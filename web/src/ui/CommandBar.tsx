// STUB (lane-d/panels): ⌘K command bar: jump to node, poll all, toggle replay.
export interface CommandBarProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}
export function CommandBar(_: CommandBarProps) {
  return null;
}
