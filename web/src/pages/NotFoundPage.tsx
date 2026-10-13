import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you are looking for does not exist."
      actions={<Link to="/" className="btn-primary">Back to dashboard</Link>}
    />
  );
}
