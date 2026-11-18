import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { openai } from '@ai-sdk/openai';

export default {
  // Model behind every agent.* step: reads OPENAI_API_KEY from environment
  agents: {
    default: {
      model: openai(process.env.OPENAI_MODEL ?? 'gpt-4o'),
      system: 'You are a thorough QA agent for the Apex Local Cut video review web app. Verify every outcome on screen.',
    },
  },
  workers: 1,
  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL ?? 'http://127.0.0.1:8793',
      command: {
        executable: 'python3',
        args: [
          'model_web_ui/browser.prototype/serve.py',
          '--assets',
          '/private/tmp/apex-browser-prototype-20261026/assets',
          '--port',
          '{port}',
        ],
        reuseExisting: true,
        log: '.e2e/logs/app.log',
      },
    },
  }],
} satisfies E2EConfig;
