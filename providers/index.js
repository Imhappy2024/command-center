/* Dispatch. Routes name an account and an operation; which provider that means,
   and whether it needs a bearer token or an IMAP credential, stops here. */

import * as google from './google.js';
import * as microsoft from './microsoft.js';
import * as imap from './imap.js';
import { getAccessToken, getImapConfig } from '../lib/accounts.js';

/* microsoft_service is the same Graph client with a different credential and a
   mailbox path instead of /me, so it is the same module under a second name
   rather than a copy of it. */
const MODULES = { google, microsoft, imap, microsoft_service: microsoft };

/* Every call resolves its own credential, so a token that expired mid-session
   refreshes transparently and an account that cannot refresh fails alone. */
async function bind(account){
  const mod = MODULES[account.provider];
  if (!mod) throw new Error(`Unknown provider ${account.provider}`);
  const auth = account.provider === 'imap'
    ? { config: await getImapConfig(account.id) }
    : { token: await getAccessToken(account.id) };
  return { mod, auth };
}

export async function listMail(account, folder, limit){
  const { mod, auth } = await bind(account);
  return mod.listMail({ ...auth, acct: account.id, folder, limit });
}

export async function counts(account){
  const { mod, auth } = await bind(account);
  return mod.counts(auth);
}

export async function getMail(account, id, folder){
  const { mod, auth } = await bind(account);
  return mod.getMail({ ...auth, acct: account.id, id, folder });
}

export async function setRead(account, id, read){
  const { mod, auth } = await bind(account);
  return mod.setRead({ ...auth, id, read });
}

export async function setStar(account, id, star){
  const { mod, auth } = await bind(account);
  return mod.setStar({ ...auth, id, star });
}

export async function move(account, id, folder){
  const { mod, auth } = await bind(account);
  return mod.move({ ...auth, id, folder });
}

export async function hardDelete(account, id){
  const { mod, auth } = await bind(account);
  return mod.hardDelete({ ...auth, id });
}

export async function send(account, payload){
  const { mod, auth } = await bind(account);
  return mod.send({ ...auth, ...payload });
}

export async function listEvents(account, from, to){
  const { mod, auth } = await bind(account);
  if (!mod.listEvents) throw new Error(`${account.provider} has no calendar`);
  return mod.listEvents({ ...auth, cal: account.id, from, to, mailbox: account.mailbox });
}

/* Creating, changing and cancelling. Only a provider that implements them is
   offered, which is what lets the UI hide the controls rather than show a New
   event button that answers 500 on a calendar it can only read. */
export const canWriteEvents = account => Boolean(MODULES[account.provider]?.createEvent);

export async function createEvent(account, payload){
  const { mod, auth } = await bind(account);
  if (!mod.createEvent) throw new Error(`${account.provider} cannot create events`);
  return mod.createEvent({ ...auth, mailbox: account.mailbox, ...payload });
}

export async function updateEvent(account, id, payload){
  const { mod, auth } = await bind(account);
  if (!mod.updateEvent) throw new Error(`${account.provider} cannot change events`);
  return mod.updateEvent({ ...auth, mailbox: account.mailbox, id, ...payload });
}

export async function deleteEvent(account, id){
  const { mod, auth } = await bind(account);
  if (!mod.deleteEvent) throw new Error(`${account.provider} cannot cancel events`);
  return mod.deleteEvent({ ...auth, mailbox: account.mailbox, id });
}

/* Which providers can permanently delete. Gmail cannot without the full
   mail.google.com scope, so the UI hides the control rather than offering a
   button that always errors. */
export const canHardDelete = provider => provider !== 'google';
