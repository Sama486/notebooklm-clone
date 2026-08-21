import { z } from 'zod';
import { limits } from '../config.js';

// Zugangsdaten werden validiert wie jede andere Eingabe auch.
export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('keine gültige E-Mail-Adresse')
    .max(limits.auth.emailMax),
  password: z
    .string()
    // bcrypt berücksichtigt nur die ersten 72 Bytes; die Obergrenze verhindert
    // außerdem, dass jemand mit sehr langen Eingaben CPU-Zeit verbrennt.
    .min(limits.auth.passwordMin, `mindestens ${limits.auth.passwordMin} Zeichen`)
    .max(limits.auth.passwordMax),
});

export type Credentials = z.infer<typeof credentialsSchema>;
