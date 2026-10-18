/**
 * Envoi optionnel. Sans RESEND_API_KEY, les e-mails ne partent pas :
 * le back-office reçoit le lien à transmettre depuis leprincegaye@ / rachel@.
 */
export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<boolean> {
  const key = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.MAIL_FROM || 'URGAD <leprincegaye@urgad.fr>').trim();
  if (!key) {
    console.log('[MAIL] non envoyé (RESEND_API_KEY absent) →', opts.to, opts.subject);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, text: opts.text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[MAIL] Resend', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[MAIL] échec:', e?.message || e);
    return false;
  }
}
