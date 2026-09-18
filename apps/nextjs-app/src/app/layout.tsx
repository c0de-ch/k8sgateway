import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Next.js BFF", template: "%s · Next.js BFF" },
  description: "Backend-for-frontend demo: OIDC login on the server, tokens in an encrypted cookie, bearer relay to APIs on Kubernetes",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="page">{children}</main>
        <footer className="footer">
          k8sgateway tutorial · Next.js 16 · tokens never leave the server · <a href="/api/auth/session">/api/auth/session</a>
        </footer>
      </body>
    </html>
  );
}
