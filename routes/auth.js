import express from 'express';
import path from 'node:path';

export function authRoutes({ auth, publicDir }){
  const r = express.Router();

  r.get('/login', (req, res) => {
    if (auth.valid(req)) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  r.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (!auth.check(req.body?.password || '')) return res.redirect('/login?error=1');
    auth.issue(res);
    res.redirect('/');
  });

  r.post('/logout', (req, res) => {
    auth.clear(res);
    res.redirect('/login');
  });

  return r;
}
