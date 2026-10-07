import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AETHER · airport disruption recovery",
  description: "Multi-agent airport disruption recovery on a synthetic airport: a weather agent, four parallel analysts, a real gate solver, a synthesizer that reads compact results only, synchronized split-view comparison and a dispatcher approval gate. Model calls are simulated; routing, solver and cost telemetry are real.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#03050a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
