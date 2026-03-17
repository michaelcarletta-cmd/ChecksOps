import { ReactNode } from "react";

export const metadata = {
  title: "Darwin Estimate Builder",
  description: "AI-assisted property damage estimate builder"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
