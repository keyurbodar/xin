import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  ArrowRight,
  ArrowUp,
  Bell,
  Brain,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Clock,
  Code,
  Copy,
  Ellipsis,
  File,
  Folder,
  Image,
  Inbox,
  Key,
  Layers,
  LayoutGrid,
  Link,
  Menu,
  MessageSquare,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-solid"

const ICONS = {
  inbox: Inbox,
  search: Search,
  grid: LayoutGrid,
  plus: Plus,
  settings: Settings,
  calendar: Calendar,
  "chevron-right": ChevronRight,
  "circle-x": CircleX,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "arrow-up": ArrowUp,
  "arrow-right": ArrowRight,
  paperclip: Paperclip,
  layers: Layers,
  code: Code,
  check: Check,
  x: X,
  copy: Copy,
  more: Ellipsis,
  folder: Folder,
  file: File,
  clock: Clock,
  square: Square,
  stop: Square,
  play: Play,
  panel: PanelRight,
  menu: Menu,
  refresh: RefreshCw,
  trash: Trash2,
  pin: Pin,
  pencil: Pencil,
  message: MessageSquare,
  upload: Upload,
  link: Link,
  sliders: SlidersHorizontal,
  bell: Bell,
  brain: Brain,
  users: Users,
  image: Image,
  key: Key,
} as const

export type IconName = keyof typeof ICONS

export const isIconName = (name: string): name is IconName => name in PATHS

export function Icon(props: { name: IconName; size?: number; class?: string; strokeWidth?: number }): JSX.Element {
  return (
    <Dynamic
      component={ICONS[props.name]}
      size={props.size ?? 16}
      stroke-width={props.strokeWidth ?? 1.5}
      class={props.class ?? ""}
      aria-hidden="true"
    />
  )
}
