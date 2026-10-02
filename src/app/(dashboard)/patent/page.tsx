import { redirect } from 'next/navigation';

export default function PatentPage() {
  redirect('/chat?tool=patent');
}
