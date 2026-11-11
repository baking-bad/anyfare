import { Button } from '../components/Button';
import { ErrorState } from '../components/ErrorState';
import { unavailableLine, unavailableTitle } from './content';

/** The receipt could not be read: the API is down or too slow. */
export const ReceiptUnavailable = () => (
  <div className="receipt-state stack-lg">
    <ErrorState title={unavailableTitle} action={<Button variant="outline" href="/calls">Back to Calls</Button>}>
      {unavailableLine}
    </ErrorState>
  </div>
);
