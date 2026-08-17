/* IMAP and SMTP, for mailboxes with no OAuth.

   Authenticated with an app password rather than a token, so there is nothing to
   refresh and no status='reauth' cycle: the credential works until the user
   revokes it at the host. Feeds mail only — IMAP has no calendar, so these
   accounts never appear as a calendar toggle.

   A connection is opened per operation. IMAP has no stateless request model, and
   pooling long-lived connections for a dashboard that polls on demand would cost
   more in idle sockets and reconnect handling than the extra second is worth. */

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { message, parseAddress, toSnippet } from '../lib/normalise.js';

/* IMAP UIDs are unique per folder, not per mailbox, so an id has to carry the
   folder it came from or an action would not know where to look. Gmail and
   Graph ids are mailbox-wide and need no such thing. */
const encodeId = (folder, uid) => `${folder}:${uid}`;

function decodeId(id){
  const at = String(id).indexOf(':');
  if (at < 1) throw new Error(`Malformed IMAP message id: ${id}`);
  return { folder: String(id).slice(0, at), uid: Number(String(id).slice(at + 1)) };
}

function open(config){
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.email,
      password: config.password,
      host: config.imapHost,
      port: config.imapPort,
      tls: true,
      // SNI, without which shared hosts hand back the wrong certificate.
      tlsOptions: { servername: config.imapHost },
      authTimeout: 15_000,
      connTimeout: 20_000
    });
    const fail = err => { imap.removeAllListeners(); reject(err); };
    imap.once('ready', () => { imap.removeListener('error', fail); resolve(imap); });
    imap.once('error', fail);
    imap.connect();
  });
}

async function withConnection(config, fn){
  const imap = await open(config);
  try {
    return await fn(imap);
  } finally {
    /* end() flushes a LOGOUT; destroy() is the backstop for a socket that is
       already gone, where end() would otherwise hang the request. */
    try { imap.end(); } catch { imap.destroy(); }
  }
}

const promisify = (imap, method, ...args) =>
  new Promise((resolve, reject) =>
    imap[method](...args, (err, out) => err ? reject(err) : resolve(out)));

/* Folder names are host-specific: Gmail over IMAP uses [Gmail]/Trash, Fastmail
   uses Trash, others localise them entirely. RFC 6154 SPECIAL-USE attributes are
   the only reliable way to find them, with common names as a fallback for hosts
   that do not advertise any. */
const SPECIAL = {
  drafts:  { attrib: '\\Drafts',  names: ['Drafts', '[Gmail]/Drafts', 'INBOX.Drafts'] },
  trash:   { attrib: '\\Trash',   names: ['Trash', 'Deleted Items', '[Gmail]/Trash', 'INBOX.Trash'] },
  spam:    { attrib: '\\Junk',    names: ['Junk', 'Spam', 'Junk E-mail', '[Gmail]/Spam', 'INBOX.Junk'] },
  archive: { attrib: '\\Archive', names: ['Archive', '[Gmail]/All Mail', 'INBOX.Archive'] },
  sent:    { attrib: '\\Sent',    names: ['Sent', 'Sent Items', '[Gmail]/Sent Mail', 'INBOX.Sent'] }
};

function flatten(boxes, prefix = '', delimiter = '/'){
  const out = [];
  for (const [name, box] of Object.entries(boxes || {})) {
    const full = prefix ? `${prefix}${delimiter}${name}` : name;
    out.push({ name: full, attribs: box.attribs || [] });
    if (box.children) out.push(...flatten(box.children, full, box.delimiter || delimiter));
  }
  return out;
}

async function boxFor(imap, folder){
  if (folder === 'inbox') return 'INBOX';
  const want = SPECIAL[folder];
  if (!want) throw new Error(`Unknown folder ${folder}`);

  const all = flatten(await promisify(imap, 'getBoxes'));
  const byAttrib = all.find(b => b.attribs.includes(want.attrib));
  if (byAttrib) return byAttrib.name;

  const lower = new Map(all.map(b => [b.name.toLowerCase(), b.name]));
  for (const candidate of want.names) {
    const hit = lower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function fetchAll(imap, uids, options){
  return new Promise((resolve, reject) => {
    if (!uids.length) return resolve([]);
    const out = [];
    const f = imap.fetch(uids, options);

    f.on('message', msg => {
      const item = { uid: null, flags: [], date: null, chunks: {} };
      msg.on('attributes', a => {
        item.uid = a.uid;
        item.flags = a.flags || [];
        item.date = a.date || null;
      });
      msg.on('body', (stream, info) => {
        let buf = '';
        stream.on('data', d => { buf += d.toString('utf8'); });
        stream.once('end', () => { item.chunks[info.which] = buf; });
      });
      msg.once('end', () => out.push(item));
    });

    f.once('error', reject);
    f.once('end', () => resolve(out));
  });
}

const HEADERS = 'HEADER.FIELDS (FROM TO SUBJECT DATE)';

function headerValue(raw, name){
  /* Unfolds continuation lines before matching, since a long Subject is split
     across lines with leading whitespace and would otherwise truncate. */
  const unfolded = String(raw || '').replace(/\r?\n[ \t]+/g, ' ');
  const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return m ? m[1].trim() : '';
}

export async function listMail({ config, acct, folder, limit }){
  return withConnection(config, async imap => {
    const box = await boxFor(imap, folder);
    if (!box) return [];                       // host has no such folder

    const info = await promisify(imap, 'openBox', box, true);
    if (!info.messages.total) return [];

    const uids = await promisify(imap, 'search', ['ALL']);
    if (!uids.length) return [];

    // Newest last in UID order, so the tail is the newest `limit` messages.
    const slice = uids.slice(-limit);
    const rows = await fetchAll(imap, slice, {
      bodies: [HEADERS, { which: 'TEXT', length: 600 }],
      struct: false
    });

    return rows.map(r => {
      const head = r.chunks[HEADERS] || '';
      const to = headerValue(head, 'To');
      const parsed = folder === 'drafts'
        ? parseAddress(to.split(',')[0] || '')
        : parseAddress(headerValue(head, 'From'));
      return message({
        id: encodeId(folder, r.uid),
        acct,
        folder,
        from: folder === 'drafts' ? `To: ${parsed.from}` : parsed.from,
        addr: parsed.addr,
        subject: headerValue(head, 'Subject'),
        snippet: toSnippet(r.chunks.TEXT),
        sortKey: Date.parse(headerValue(head, 'Date')) || (r.date ? r.date.getTime() : 0),
        unread: !r.flags.includes('\\Seen'),
        star: r.flags.includes('\\Flagged')
      });
    }).sort((a, b) => b.sortKey - a.sortKey);
  });
}

/* One connection, five SELECTs. openBox reports the folder's totals without
   fetching anything, and a folder the host does not have reports null. */
export async function counts({ config }){
  return withConnection(config, async imap => {
    const out = { inbox: 0, inboxUnread: 0, drafts: 0, trash: 0, spam: 0, archive: null };
    for (const key of ['inbox', 'drafts', 'trash', 'spam', 'archive']) {
      try {
        const box = await boxFor(imap, key);
        if (!box) { out[key] = null; continue; }
        const info = await promisify(imap, 'openBox', box, true);
        out[key] = info.messages.total || 0;
        /* messages.new counts \Recent, which means "arrived since another client
           last looked" — not unread. UNSEEN is the flag the sidebar means. */
        if (key === 'inbox') {
          out.inboxUnread = (await promisify(imap, 'search', ['UNSEEN'])).length;
        }
      } catch {
        out[key] = null;
      }
    }
    return out;
  });
}

export async function getMail({ config, acct, id }){
  const { folder, uid } = decodeId(id);
  return withConnection(config, async imap => {
    const box = await boxFor(imap, folder);
    if (!box) throw new Error(`Folder ${folder} not found on ${config.imapHost}`);
    await promisify(imap, 'openBox', box, true);

    const [row] = await fetchAll(imap, [uid], { bodies: [''], struct: false });
    if (!row) throw new Error('Message not found');

    const mail = await simpleParser(row.chunks[''] || '');
    const to = mail.to?.text || '';
    const parsed = folder === 'drafts' ? parseAddress(to.split(',')[0] || '')
                                       : parseAddress(mail.from?.text || '');
    return message({
      id,
      acct,
      folder,
      from: folder === 'drafts' ? `To: ${parsed.from}` : parsed.from,
      addr: parsed.addr,
      subject: mail.subject,
      snippet: toSnippet(mail.text),
      body: mail.text || toSnippet(mail.html, 20_000),
      sortKey: mail.date ? mail.date.getTime() : 0,
      unread: !row.flags.includes('\\Seen'),
      star: row.flags.includes('\\Flagged')
    });
  });
}

async function withOpenBox(config, id, fn){
  const { folder, uid } = decodeId(id);
  return withConnection(config, async imap => {
    const box = await boxFor(imap, folder);
    if (!box) throw new Error(`Folder ${folder} not found on ${config.imapHost}`);
    await promisify(imap, 'openBox', box, false);   // writable
    return fn(imap, uid, folder);
  });
}

export const setRead = ({ config, id, read }) =>
  withOpenBox(config, id, (imap, uid) =>
    promisify(imap, read ? 'addFlags' : 'delFlags', uid, '\\Seen'));

export const setStar = ({ config, id, star }) =>
  withOpenBox(config, id, (imap, uid) =>
    promisify(imap, star ? 'addFlags' : 'delFlags', uid, '\\Flagged'));

export const move = ({ config, id, folder }) =>
  withOpenBox(config, id, async (imap, uid, current) => {
    if (current === folder) return;
    const target = await boxFor(imap, folder);
    if (!target) throw new Error(`${config.imapHost} has no ${folder} folder`);
    return promisify(imap, 'move', uid, target);
  });

/* \Deleted then EXPUNGE. Unlike Gmail, nothing here blocks a real delete — the
   app password carries full mailbox rights. */
export const hardDelete = ({ config, id }) =>
  withOpenBox(config, id, async (imap, uid) => {
    await promisify(imap, 'addFlags', uid, '\\Deleted');
    return promisify(imap, 'expunge', uid);
  });

export async function send({ config, to, subject, body, replyTo }){
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // 465 is implicit TLS; 587 and 25 start plaintext and upgrade via STARTTLS.
    secure: Number(config.smtpPort) === 465,
    auth: { user: config.email, pass: config.password },
    tls: { servername: config.smtpHost }
  });
  try {
    await transport.sendMail({
      from: config.email,
      to,
      subject: subject || '',
      text: body || '',
      ...(replyTo ? { inReplyTo: replyTo, references: replyTo } : {})
    });
  } finally {
    transport.close();
  }
}

/* Proves the credentials before a row is written, so a typo in the host or
   password surfaces in the connect form rather than as an empty mailbox. */
export async function verify(config){
  await withConnection(config, async imap => {
    await promisify(imap, 'openBox', 'INBOX', true);
  });
}
