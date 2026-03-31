import { Badge } from './badge';
import { statusColor } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge className={statusColor(status)}>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}
