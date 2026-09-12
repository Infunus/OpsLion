import type { Metadata } from "next";
import "./globals.css";
import "./studio/workspace.css";

export const metadata: Metadata = {
  title: "运营狮排版台（本地版）",
  description: "本机运行的微信公众号与秀米排版工具。",
  icons: { icon: "/brand/opslion-favicon-v4.svg", shortcut: "/brand/opslion-favicon-v4.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `
    (() => {
      let dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      try {
        const saved = JSON.parse(localStorage.getItem('opslion:workspace-preferences:v1') || 'null');
        if (typeof saved?.dark === 'boolean') dark = saved.dark;
      } catch {}
      document.documentElement.dataset.motion = 'on';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    })();
  ` }} /></head><body>{children}</body></html>;
}
