import type { Metadata } from "next";
import "./globals.css";
import { StoreProvider } from "@/lib/store.tsx";
import { Shell } from "@/components/Shell.tsx";

export const metadata: Metadata = {
  title: "LumenCare · Lumen General Hospital (demo)",
  description: "Fictional EHR used as the ShowMe demo target. All data is invented.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>
          <Shell>{children}</Shell>
        </StoreProvider>
      </body>
    </html>
  );
}
