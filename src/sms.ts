/**
 * Service SMS URGAD
 * Dans le MVP, les SMS sont envoyés via un service mock pour éviter les dépendances réseau.
 * Pour la production, remplacer par Twilio, Africa's Talking ou un autre provider SMS.
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
