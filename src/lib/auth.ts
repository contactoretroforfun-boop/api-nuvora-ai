import { verifyFirebaseIdToken, DecodedIdToken } from './auth-edge';

export { verifyFirebaseIdToken };
export type { DecodedIdToken };

/**
 * Resuelve jerárquicamente el rol del usuario:
 * 1. Desde las Custom Claims del Token (si existen).
 * 2. Fallback dinámico a Firestore (/users/{uid}) si no están en claims.
 * Nota: Esta función corre exclusivamente en entornos Node.js Serverless (no Edge)
 * debido a su dependencia del SDK de firebase-admin.
 */
export async function resolveUserRole(uid: string, tokenClaimsRole?: 'admin' | 'team' | 'training'): Promise<'admin' | 'team' | 'training'> {
  if (tokenClaimsRole) {
    return tokenClaimsRole;
  }

  try {
    // Importación dinámica para resolver la dependencia de Firestore
    const { getDb } = await import('@/lib/firebase-admin');
    const db = getDb();
    
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      if (data && (data.role === 'admin' || data.role === 'team' || data.role === 'training')) {
        return data.role;
      }
    }
  } catch (error) {
    console.warn('Firestore fallback role resolution failed:', error);
  }

  // Rol por defecto según requerimiento
  return 'team';
}
