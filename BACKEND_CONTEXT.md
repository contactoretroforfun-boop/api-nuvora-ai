# Contexto de Backend y Base de Datos (Nuvora Control Panel)

Este documento detalla la estructura actual de datos y configuraciones en Firebase (Firestore & Storage) para el proyecto *Nuvora Control Panel*. Está diseñado como referencia técnica para el desarrollo de un backend externo (Node.js/Python) que deba procesar, interactuar o sincronizar los agentes configurados desde este frontend.

## 1. Estructura de Colecciones en Firestore

El proyecto utiliza una base de datos NoSQL jerárquica con la siguiente estructura principal:

```text
/agents (Collection)
  ├── /{agentId} (Document)
  │     └── /conversations (Sub-Collection - Planificada para logs)
  │           └── /{conversationId} (Document)
  └── /{agentId} (Document)
```

## 2. Esquema del Documento: `/agents/{agentId}`

Cada agente configurado a través del Wizard genera un documento principal en la colección `agents`. El ID del documento (`agentId`) se genera automáticamente en el cliente con el formato `agt_{randomId}`.

**Ejemplo de Payload:**
```json
{
  "id": "agt_xyz123",
  "status": "draft", // Puede ser "draft" (borrador) o "active" (publicado)
  "name": "Nombre del Negocio", // Usado para visualización en el Dashboard
  "client": "Nombre del Negocio",
  "currentStep": 8, // Paso donde se quedó el usuario en el Wizard (1-10)
  "updatedAt": 1715893200000, // Timestamp (Date.now())
  "data": {
    // Aquí reside la carga útil completa del agente. (Ver sección 4)
  }
}
```

## 3. Subcolección: `/agents/{agentId}/conversations`

Aunque el Control Panel actual se enfoca en la configuración del agente, el backend externo deberá manejar el registro de los mensajes en tiempo real (por ejemplo, desde Twilio o 360dialog) para alimentar el Dashboard de Conversaciones.

**Estructura esperada por el Frontend para visualización:**
```json
// Ruta: /agents/{agentId}/conversations/{conversationId}
{
  "conversationId": "conv_987654",
  "contactNumber": "+59899123456",
  "contactName": "Juan Pérez",
  "status": "active", // "active", "resolved", "handed_off"
  "lastMessageAt": 1715893205000,
  "history": [
    {
      "role": "user",
      "content": "Hola, quería agendar un turno",
      "timestamp": 1715893200000
    },
    {
      "role": "assistant",
      "content": "¡Hola Juan! Claro, ¿para qué servicio te gustaría?",
      "timestamp": 1715893205000
    }
  ]
}
```

## 4. Estructura del objeto `data` (Configuración del Wizard)

El campo `data` dentro del documento del agente es un mapa dinámico que recopila la configuración de los 10 pasos del Wizard. El backend deberá extraer esta información para construir el Prompt o System Message del LLM.

```json
"data": {
  // PASO 1: Datos Básicos
  "businessName": "Estética Lumina",
  "industry": "Centro de Estética",
  "location": "Pocitos, Montevideo",
  "whatsappNumber": "+59899123456",
  "schedule": [
    { "day": "Lunes", "open": true, "start": "09:00", "end": "18:00" },
    { "day": "Domingo", "open": false, "start": "00:00", "end": "00:00" }
  ],
  "tone": "Cercano",

  // PASO 7: Identidad (UI Widget)
  "color": "#8b5cf6",
  "position": "right",
  "logoUrl": "https://firebasestorage.googleapis.com/v0/b/nuvora-demo.appspot.com/o/agents%2Fagt_xyz123%2Flogo.png",

  // PASO 8: Módulos Avanzados (Habilitados por Toggle)
  "modules": {
    "reviews": {
      "enabled": true,
      "delayValue": 45,
      "delayUnit": "Minutos",
      "messages": {
        "initial": "¡Hola {{nombre}}! ¿Cómo te fue con tu {{servicio}}?",
        "followup": "¿Podrías contarnos un poco más?"
      },
      "sentimentStrictness": 70,
      "platforms": {
        "google": "https://g.page/review/...",
        "tripadvisor": ""
      }
    },
    "scheduling": {
      "enabled": true,
      "platform": "cal", // "cal" | "calendly"
      "link": "https://cal.com/estetica-lumina",
      "notifyTeam": true,
      "notificationNumber": "+59899000111"
    },
    "tracking": {
      "enabled": true,
      "tabs": { ... } // Leads / Retención
    }
  }
  
  // Nota: Otros pasos (2, 3, 4, 5) alimentan directamente este mismo objeto 'data'
  // con claves similares según los inputs del frontend.
}
```

## 5. Variables y Configuraciones de Firebase

El Frontend se conecta a Firebase utilizando las siguientes variables de entorno. El Backend debe utilizar estas mismas credenciales (o un Service Account vinculado al mismo proyecto) para tener acceso de lectura/escritura a la colección `agents`.

**Variables inyectadas en Frontend (`.env.local`):**
```env
NEXT_PUBLIC_FIREBASE_API_KEY="..."
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="..."
NEXT_PUBLIC_FIREBASE_PROJECT_ID="..."
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="..."
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="..."
NEXT_PUBLIC_FIREBASE_APP_ID="..."
```

**Firebase Storage:**
Las imágenes subidas (Logos) en el Paso 7 se almacenan bajo la ruta:
`gs://{STORAGE_BUCKET}/agents/{agentId}/logo.{ext}`

## 6. Integración Externa & Mock Mode (Fallback Local)

- **Modo Híbrido:** El Frontend actual posee un fallback a `localStorage` llamado "Mock Mode". Si el Backend nota que faltan datos en Firebase durante pruebas iniciales, puede deberse a que el usuario interactuó sin credenciales de Firebase configuradas, guardándose bajo las claves `draft_{agentId}` en el navegador.
- **Transición de Estado:** Cuando el usuario llega al Paso 10 (Despliegue) y hace clic en "Publicar", el campo `status` del documento pasará de `"draft"` a `"active"`. El Backend debe suscribirse (usando `onSnapshot` o Webhooks) a los documentos cuyo status cambie a "active" para inicializar la conexión con Twilio/WhatsApp API.
