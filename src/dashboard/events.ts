import { EventEmitter } from 'events';

// Singleton — cualquier módulo puede importar `dash` y emitir eventos
export const dash = new EventEmitter();
dash.setMaxListeners(100);
