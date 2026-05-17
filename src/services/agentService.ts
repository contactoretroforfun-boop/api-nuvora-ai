import { getDb } from '../lib/firebase-admin';

export async function getAgentByWhatsApp(phoneNumber: string) {
  const db = getDb();
  
  // 1. Verificar si es el número del Sandbox de Twilio (+1 415 523 8886)
  if (phoneNumber === '+14155238886') {
    const sandboxSnapshot = await db.collection('agents')
      .where('sandboxConnection.active', '==', true)
      .limit(1)
      .get();
      
    if (!sandboxSnapshot.empty) {
      const doc = sandboxSnapshot.docs[0];
      return { id: doc.id, ...doc.data() } as any;
    }
  }

  // 2. Buscar por número real de producción
  let snapshot = await db.collection('agents')
    .where('whatsappConnection.phoneNumber', '==', phoneNumber)
    .limit(1)
    .get();
    
  // Fallback a la estructura antigua por compatibilidad
  if (snapshot.empty) {
    snapshot = await db.collection('agents')
      .where('data.whatsappNumber', '==', phoneNumber)
      .limit(1)
      .get();
  }
  
  if (snapshot.empty) {
    return null;
  }
  
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as any;
}

export async function getConversationHistory(agentId: string, conversationId: string) {
  const db = getDb();
  const snapshot = await db
    .collection('agents')
    .doc(agentId)
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();

  if (snapshot.empty) {
    return [];
  }

  // Reverse to get chronological order
  const messages = snapshot.docs.map(doc => doc.data()).reverse();
  return messages;
}

export async function saveMessage(agentId: string, conversationId: string, role: 'user' | 'assistant', content: string) {
  const timestamp = Date.now();
  
  const db = getDb();
  
  // Save message in subcollection
  await db
    .collection('agents')
    .doc(agentId)
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .add({
      role,
      content,
      timestamp,
    });
    
  // Also update the main conversation document with lastActivity
  await db
    .collection('agents')
    .doc(agentId)
    .collection('conversations')
    .doc(conversationId)
    .set({
      conversationId,
      contactNumber: conversationId,
      lastMessageAt: timestamp,
      status: 'active'
    }, { merge: true });
}
