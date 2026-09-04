/**
 * Seller-portal UI surface. The generic building blocks are shared with the
 * admin kit (they are section-agnostic); re-exported here so seller code has its
 * own stable import path and can diverge cheaply later.
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
  DataTable,
  type Column,
  Modal,
  ConfirmDialog,
  SearchInput,
  FilterBar,
  FilterSelect,
  Pagination,
  FormField,
  Select,
  notify,
  usePersistentAction,
} from "@/components/admin/ui";
