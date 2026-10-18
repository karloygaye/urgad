/**
 * Envoi transactionnel.
 * 1. SMTP OVH si SMTP_HOST + SMTP_USER + SMTP_PASS
 * 2. sinon Resend si RESEND_API_KEY
 * 3. sinon log (le back-office garde le lien)
 */
import nodemailer from 'nodemailer';

export type MailOpts = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** professional | establishment | admin — choisit rachel@ ou leprincegaye@ */
  space?: string;
};

function trimEnv(name: string) {
  return (process.env[name] || '').trim();
}

function mailboxFor(space?: string) {
  const rachelUser = trimEnv('SMTP_USER_RACHEL') || 'rachel@urgad.fr';
  const rachelPass = trimEnv('SMTP_PASS_RACHEL');
  const defaultUser = trimEnv('SMTP_USER') || 'leprincegaye@urgad.fr';
  const defaultPass = trimEnv('SMTP_PASS');
  if (space === 'professional' && rachelPass) {
    return { user: rachelUser, pass: rachelPass, fromName: 'URGAD' };
  }
  return { user: defaultUser, pass: defaultPass, fromName: 'URGAD' };
}

export function mailStatus(): { configured: boolean; transport: 'smtp' | 'resend' | 'none' } {
  if (trimEnv('SMTP_HOST') && trimEnv('SMTP_USER') && trimEnv('SMTP_PASS')) {
    return { configured: true, transport: 'smtp' };
  }
  if (trimEnv('RESEND_API_KEY')) return { configured: true, transport: 'resend' };
  return { configured: false, transport: 'none' };
}

function formatFrom(mailbox: string, name = 'URGAD') {
  return name + ' <' + mailbox + '>';
}

async function sendSmtp(opts: MailOpts): Promise<boolean> {
  const host = trimEnv('SMTP_HOST');
  const box = mailboxFor(opts.space);
  if (!host || !box.user || !box.pass) return false;
  const port = parseInt(trimEnv('SMTP_PORT') || '465', 10) || 465;
  const secure = trimEnv('SMTP_SECURE') ? trimEnv('SMTP_SECURE') !== '0' : port === 465;
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: box.user, pass: box.pass },
    tls: { minVersion: 'TLSv1.2' },
  });
  const from = opts.from || formatFrom(box.user, box.fromName);
  const replyTo = opts.replyTo || (opts.space === 'professional' ? 'rachel@urgad.fr' : 'leprincegaye@urgad.fr');
  await transporter.sendMail({
    from,
    to: opts.to,
    replyTo,
    subject: opts.subject,
    text: opts.text,
    html: opts.html || undefined,
  });
  return true;
}

async function sendResend(opts: MailOpts): Promise<boolean> {
  const key = trimEnv('RESEND_API_KEY');
  if (!key) return false;
  const from = opts.from || trimEnv('MAIL_FROM') || 'URGAD <leprincegaye@urgad.fr>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [opts.to],
      reply_to: opts.replyTo || undefined,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error('Resend ' + res.status + ' ' + body.slice(0, 300));
  }
  return true;
}

export async function sendMail(opts: MailOpts): Promise<boolean> {
  const to = String(opts.to || '').trim();
  if (!to || !to.includes('@')) return false;
  try {
    if (trimEnv('SMTP_HOST') && trimEnv('SMTP_USER') && trimEnv('SMTP_PASS')) {
      const ok = await sendSmtp(opts);
      if (ok) console.log('[MAIL] smtp →', to, opts.subject);
      return ok;
    }
    if (trimEnv('RESEND_API_KEY')) {
      const ok = await sendResend(opts);
      if (ok) console.log('[MAIL] resend →', to, opts.subject);
      return ok;
    }
    console.log('[MAIL] non envoyé (SMTP / RESEND absents) →', to, opts.subject);
    return false;
  } catch (e: any) {
    console.error('[MAIL] échec:', e?.message || e);
    return false;
  }
}

export function resetMailHtml(resetUrl: string, spaceLabel: string) {
  const safe = String(resetUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="fr"><body style="margin:0;background:#0A0E1A;font-family:Inter,Arial,sans-serif;color:#F8FAFC">
  <div style="max-width:480px;margin:24px auto;padding:28px;background:#161B2E;border-radius:16px;border:1px solid rgba(255,255,255,.1)">
    <p style="letter-spacing:2px;font-size:11px;color:#D4AF37;text-transform:uppercase;margin:0 0 12px">URGAD</p>
    <h1 style="font-size:22px;margin:0 0 12px">Nouveau mot de passe</h1>
    <p style="color:#94A3B8;font-size:14px;line-height:1.5">Vous avez demandé à réinitialiser le mot de passe de votre espace ${spaceLabel}.</p>
    <p style="margin:24px 0"><a href="${safe}" style="display:inline-block;padding:12px 18px;background:linear-gradient(135deg,#D4AF37,#F5D76E);color:#0A0E1A;font-weight:700;text-decoration:none;border-radius:12px">Choisir un mot de passe</a></p>
    <p style="color:#94A3B8;font-size:12px;line-height:1.5">Lien valable 1 heure. Si le bouton ne s’ouvre pas :<br>${safe}</p>
    <p style="color:#64748B;font-size:12px;margin-top:20px">Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.</p>
  </div>
</body></html>`;
}
