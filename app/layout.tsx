import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Ударения в именах', description: 'Проверка и отправка ударений' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
