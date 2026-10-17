/**
 * SMS volontairement non utilisés : le téléphone est enregistré à l'inscription,
 * les alertes (y compris missions urgentes) passent par notify() — in-app + push / navigateur.
 */

export interface SMSSendResult {
  success: boolean;
  message: string;
  provider: string;
}

export function sendSMS(phone: string, message: string): SMSSendResult {
  console.log(`[SMS MOCK] À: ${phone} | Message: ${message}`);
  return {
    success: true,
    message: `Code envoyé (mock) à ${phone}`,
    provider: 'mock',
  };
}
