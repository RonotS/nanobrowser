// The signed-in person's role in the panel header.
/**
 * A Command Center role as people write it: Command Center keeps it lowercase ("media buyer", "csm"). Short ones are
 * initials (CSM, ISA, VA); none for a member with no position.
 */
export function roleLabel(role: string): string {
  if (!role || role.startsWith('__')) return '';
  return role
    .split(/\s+/)
    .map(word => (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}
