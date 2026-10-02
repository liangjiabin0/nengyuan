import { redirect } from 'next/navigation';

export default function DataPage() {
  redirect('/settings?tab=data');
}
