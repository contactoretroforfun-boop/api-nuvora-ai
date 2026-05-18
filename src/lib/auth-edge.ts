import * as jose from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'nuvora-control-panel';
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

export interface DecodedIdToken {
  uid: string;
  email?: string;
  role?: 'admin' | 'team' | 'training';
  [key: string]: any;
}

/**
 * Verifica criptográficamente un Firebase ID Token (JWT) usando jose y JWKS de Google.
 * Totalmente compatible con entornos Edge/Vercel Middleware sin requerir Node.js APIs.
 */
export async function verifyFirebaseIdToken(token: string): Promise<{ isValid: boolean; payload?: DecodedIdToken; error?: string }> {
  try {
    if (!token) {
      return { isValid: false, error: 'Token is empty' };
    }

    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: PROJECT_ID,
    });

    const uid = payload.sub as string;
    const email = payload.email as string | undefined;
    const role = payload.role as 'admin' | 'team' | 'training' | undefined;

    return {
      isValid: true,
      payload: {
        ...payload,
        uid,
        email,
        role,
      },
    };
  } catch (error: any) {
    console.error('JWT Verification failed:', error.message || error);
    return { isValid: false, error: error.message || 'Verification failed' };
  }
}
