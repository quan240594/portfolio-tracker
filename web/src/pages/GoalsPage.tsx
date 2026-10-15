import { PageHeader } from '../components/Layout';
import { GoalsView } from '../features/goals/GoalsView';

export function GoalsPage() {
  return (
    <>
      <PageHeader title="Goals" description="Plan a portfolio value or passive income target: when will you get there, and what does it take?" />
      <GoalsView />
    </>
  );
}

export default GoalsPage;
