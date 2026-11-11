import { buttonClass } from './Button';
import { Logo } from './Logo';
import { MobileMenu } from './MobileMenu';
import { NavLinks } from './NavLinks';
import { ScrollHeader } from './ScrollHeader';
import { ThemeMenu } from './ThemeMenu';
import { ViewSwitch } from './ViewSwitch';

/**
 * The header: the logo, the main links, the Human / Agent switch, the theme menu, and the Console button
 * that links to `consoleHref`. Sticky, 73 px. Below 900 px the links move behind a menu button. On the console
 * host (`siteUrl` is given) the logo and the links lead to the public site, the Human / Agent switch is gone,
 * and the Console button is the current page.
 */
export const SiteHeader = ({ consoleHref, siteUrl }: { readonly consoleHref: string; readonly siteUrl?: string }) => (
  <ScrollHeader>
    <div className="container ruled">
      <Logo {...siteUrl === undefined ? {} : { href: `${siteUrl}/` }} />
      <nav className="nav" aria-label="Main"><NavLinks {...siteUrl === undefined ? {} : { base: siteUrl }} /></nav>
      <div className="header-end">
        {siteUrl === undefined ? <ViewSwitch className="hide-sm" /> : null}
        <ThemeMenu />
        <a className={buttonClass({ size: 'sm' })} href={consoleHref} {...siteUrl === undefined ? {} : { 'aria-current': 'page' as const }}>Console</a>
        <MobileMenu {...siteUrl === undefined ? {} : { base: siteUrl, showView: false }} />
      </div>
    </div>
  </ScrollHeader>
);
