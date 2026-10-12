import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import ReviewApp from '@/components/ReviewApp';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const email = await getSession();
  if (!email) redirect('/login');
  return <ReviewApp email={email} />;
}
