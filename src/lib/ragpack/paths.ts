export function safeBundleKey(key: string) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function paperBundleRel(paperKey: string) {
  return `files/papers/${safeBundleKey(paperKey)}.pdf`;
}

export function mentorBundleRel(mentorKey: string) {
  return `files/mentors/${safeBundleKey(mentorKey)}.md`;
}
