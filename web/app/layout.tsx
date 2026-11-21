import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FILMAI — text & image to video",
  description: "Describe a film. Wan 2.2 turns it into video.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
