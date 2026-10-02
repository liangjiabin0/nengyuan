import { redirect } from 'next/navigation';

export default function ResearchReviewPage() {
  redirect('/chat?tool=research-review');
}
