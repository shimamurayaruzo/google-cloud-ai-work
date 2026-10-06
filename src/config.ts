// 環境変数を一か所で読む。秘密情報は Cloud Run の環境変数にだけ置く（docs/02 §8）。
function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export type TasksMode = 'cloud' | 'inline';
export type TtsMode = 'device' | 'cloud';
export type AgentMode = 'adk' | 'rules';

export const config = {
  projectId: env('GOOGLE_CLOUD_PROJECT', 'eco-diode-508102-q7'),
  location: env('GOOGLE_CLOUD_LOCATION', 'global'),
  region: env('CLOUD_RUN_REGION', 'asia-northeast1'),
  firestoreDatabase: env('FIRESTORE_DATABASE', 'default'),
  geminiModel: env('GEMINI_MODEL', 'gemini-2.5-flash'),
  /** 自分の公開 URL。Cloud Tasks のターゲットと OIDC の audience に使う */
  serviceUrl: env('SERVICE_URL'),
  port: Number(env('PORT', '8080')),

  appPassphrase: env('APP_PASSPHRASE'),
  internalToken: env('INTERNAL_TOKEN'),
  /** "hh_main:token1,hh_demo:token2" */
  deviceTokens: parseDeviceTokens(env('DEVICE_TOKENS')),
  defaultHouseholdId: env('HOUSEHOLD_ID', 'hh_main'),

  line: {
    channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN'),
    channelSecret: env('LINE_CHANNEL_SECRET'),
  },
  slackWebhookUrl: env('SLACK_WEBHOOK_URL'),

  tasksMode: (env('TASKS_MODE', 'cloud') as TasksMode),
  tasksQueue: env('TASKS_QUEUE', 'mimamori'),
  /** Cloud Tasks が /internal/* を叩くときの OIDC 用サービスアカウント（未設定なら Cloud Run 既定の SA） */
  tasksServiceAccount: env('TASKS_SERVICE_ACCOUNT'),
  ttsMode: (env('TTS_MODE', 'device') as TtsMode),
  ttsVoice: env('TTS_VOICE', 'ja-JP-Neural2-B'),
  ttsTimeoutMs: Number(env('TTS_TIMEOUT_MS', '8000')),
  llmTimeoutMs: Number(env('LLM_TIMEOUT_MS', '20000')),
  agentMode: (env('AGENT_MODE', 'adk') as AgentMode),

  timezone: 'Asia/Tokyo',
} as const;

function parseDeviceTokens(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
