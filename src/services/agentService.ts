import { getDb } from '../lib/firebase-admin';

export async function getAgentByWhatsApp(phoneNumber: string) {
  const db = getDb();
  const snapshot = await db.collection('agents').where('data.whatsappNumber', '==', phoneNumber).limit(1).get();
  
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
