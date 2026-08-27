import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: 'Kodex',
  description: 'Kodex desktop workspace for coding tasks, reviews, and automations.',
  openGraph: {
    title: 'Kodex',
    description: 'A focused desktop workspace for coding with agents.',
    images: [{ url: '/og.png', width: 1731, height: 909 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kodex',
    description: 'A focused desktop workspace for coding with agents.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
