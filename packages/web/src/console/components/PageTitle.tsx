import type { ReactNode } from 'react';

/** The top of a console page: its title, a line under it, and room for buttons at the end. */
export const PageTitle = ({ title, lead, actions }: { readonly title: string; readonly lead?: ReactNode; readonly actions?: ReactNode }) => (
  <div className="page-head">
    <div className="page-head-text">
      <h1 className="page-title">{title}</h1>
      {lead === undefined ? null : <p className="small muted">{lead}</p>}
    </div>
    {actions === undefined ? null : <div className="row">{actions}</div>}
  </div>
);
