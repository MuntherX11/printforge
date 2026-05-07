import { Badge } from './badge';
import { formatStatus, statusColor } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge className={statusColor(status)}>
      {formatStatus(status)}
    </Badge>
  );
}
