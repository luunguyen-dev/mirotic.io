/**
 * types.ts — Shared cross-module types.
 * Tách khỏi prototyper/db để tránh circular deps.
 */

export type ProjectType = "web-frontend" | "full-stack" | "cli" | "browser-extension" | "mobile-expo";

export type Idea = {
  title: string; slug: string; type: ProjectType;
  pitch: string; why: string; source: string;
  title_vi?: string; pitch_vi?: string; why_vi?: string;
  title_en?: string; pitch_en?: string; why_en?: string;
  features?: string[]; features_vi?: string[]; features_en?: string[];
  target_user?: string; target_user_vi?: string; target_user_en?: string;
  demo_hours?: number;
  why_now?: string; why_now_vi?: string; why_now_en?: string;
  risk?: string; risk_vi?: string; risk_en?: string;
  // Diễn giải của Prototyper (hiện trong drawer dưới Features), song ngữ:
  flow_vi?: string; flow_en?: string;                       // đoạn văn kể user flow end-to-end
  feature_notes_vi?: string[]; feature_notes_en?: string[]; // song song features — mỗi feature 1-2 câu vì sao cần/dùng lúc nào
};

export type ScoredIdea = Idea & { score: number; url?: string };

// Build plan checklist step.
export type PlanStep = {
  key: string;
  label_en: string;
  label_vi: string;
  status: "pending" | "in_progress" | "done" | "failed";
  note?: string;
};

export type Plan = {
  problem: string;
  tenStar: string;
  scopeCut: string;
  stack: string;
  buildSteps: string[];
  testPlan: string[];
  tasteDecisions: string[];
  steps?: PlanStep[];   // detailed checklist (sinh khi Approve)
};

export type Result = {
  repoUrl: string;
  branch: string;
  localUrl: string;      // web: http://localhost:3xxx (chỉ Mac worker truy cập)
  lanUrl?: string;       // web: http://<mac-LAN-IP>:3xxx (phone/máy khác cùng WiFi truy cập)
  deployedUrl?: string;  // web: https://<slug>.mirotic.io
  publicPort?: number;
  error?: string;
  // Mobile-specific fields (mobile-expo)
  expoUrl?: string;      // exp://u.expo.dev/... tunnel URL — user scan QR bằng Expo Go (nếu manual start tunnel)
  expoQr?: string;       // base64 data URL của QR code image (khi expoUrl có)
  cliHint?: string;      // command user chạy tay để start tunnel + get QR (mobile)
  apkUrl?: string;       // https://<slug>.mirotic.io/app.apk (deployed prod)
};
