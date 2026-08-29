/**
 * Admin UI kit — reusable building blocks for every admin section.
 * Import from "@/components/admin/ui".
 */
export {
  Card,
  CardHeader,
  StatCard,
  PageHeader,
  Breadcrumbs,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
} from "./primitives";
export { DataTable, type Column } from "./data-table";
export { Modal, ConfirmDialog } from "./overlays";
export {
  SearchInput,
  FilterBar,
  FilterSelect,
  Pagination,
  FormField,
  Select,
} from "./controls";
export { Tabs, type TabItem } from "./tabs";
export { ActionMenu, type ActionItem } from "./action-menu";
export { notify } from "./notify";
export { usePersistentAction } from "./use-form";
