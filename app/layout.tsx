import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Auto Naming System', description: 'автоматичсекое проставление ударений' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
