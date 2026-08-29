import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { UserCircle } from '@phosphor-icons/react'
import { useAuthenticatedApi, useOptionalAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'
import { currentReturnTo, requestAccessLogin } from '../accessSession'
import { useTranslation } from '../i18n'

export default function UserMenu() {
  const { t } = useTranslation('shell')
  const auth = useOptionalAuthenticatedApi()
  if (!auth) {
    return (
      <button
        type="button"
        onClick={() => requestAccessLogin(currentReturnTo())}
        className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-kumo-tint text-kumo-strong transition-colors hover:bg-kumo-fill md:h-7 md:w-7"
        title={t('user.signIn')}
        aria-label={t('user.signIn')}
      >
        <UserCircle size={18} weight="regular" />
      </button>
    )
  }
  return <AuthenticatedUserMenu />
}

function AuthenticatedUserMenu() {
  const { t } = useTranslation('shell')
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex h-11 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-kumo-tint transition-colors hover:bg-kumo-fill md:h-7 md:w-7"
            title={t('user.openMenu')}
            aria-label={t('user.openMenu')}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          {t('nav.profile')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          {t('nav.providers')}
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            {t('nav.admin')}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          {t('user.signOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
