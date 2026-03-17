export const metadata = {
  title: "AI Estimate Builder",
  description: "Upload damage photos for AI-powered insurance estimate generation"
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
