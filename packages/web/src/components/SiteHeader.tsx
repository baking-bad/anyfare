import { Button } from './Button';
import { Logo } from './Logo';
import { MobileMenu } from './MobileMenu';
import { NavLinks } from './NavLinks';
import { ScrollHeader } from './ScrollHeader';
import { ThemeMenu } from './ThemeMenu';
import { ViewSwitch } from './ViewSwitch';

/**
 * The header: the logo, the main links, the Human / Agent switch, the theme menu, and the Console button
 * that links to `consoleUrl`. Sticky, 73 px. Below 900 px the links move behind a menu button.
 */
export const SiteHeader = ({ consoleUrl }: { readonly consoleUrl: string }) => (
  <ScrollHeader>
    <div className="container ruled">
      <Logo />
      <nav className="nav" aria-label="Main"><NavLinks /></nav>
      <div className="header-end">
        <ViewSwitch className="hide-sm" />
        <ThemeMenu />
        <Button size="sm" href={consoleUrl}>Console</Button>
        <MobileMenu />
      </div>
    </div>
  </ScrollHeader>
);
