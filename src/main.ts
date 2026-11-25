import '@fontsource/inter-tight/300.css';
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './design/styles.css';

import { BlockdropApp } from './media/app.js';

export function bootstrapApp(root: HTMLElement): BlockdropApp {
  const app = new BlockdropApp(root);
  app.mount();
  root.dataset.ready = 'true';
  return app;
}

const rootEl = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (rootEl) {
  bootstrapApp(rootEl);
}

