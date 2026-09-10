import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/Feedback.jsx';
import { Button } from '../components/ui/Button.jsx';

export default function NotFoundPage() {
  return (
    <Card>
      <EmptyState
        icon={Compass}
        title="That page does not exist"
        description="The link may be out of date, or the engagement it pointed at has been deleted."
      >
        <Button as={Link} to="/" variant="primary" size="sm">
          Back to the dashboard
        </Button>
      </EmptyState>
    </Card>
  );
}
