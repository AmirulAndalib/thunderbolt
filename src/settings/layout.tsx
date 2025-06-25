import { SidebarFooter } from '@/components/sidebar-footer'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { ArrowLeft, Bot, Plug, Server, SlidersHorizontal } from 'lucide-react'
import { Link, Outlet, useLocation } from 'react-router'

export default function SettingsLayout() {
  const { open, setOpen } = useSidebar()
  const location = useLocation()
  const currentPath = location.pathname

  return (
    <>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <Sidebar>
          <SidebarContent className="flex flex-col h-full">
            <SidebarGroup>
              <SidebarGroupContent className="flex justify-between w-full flex-1">
                <SidebarTrigger className="cursor-pointer" />
                <SidebarMenuButton
                  asChild
                  className="w-fit pr-0 pl-0 aspect-square items-center justify-center cursor-pointer"
                >
                  <Link to="/">
                    <ArrowLeft className="size-5" />
                  </Link>
                </SidebarMenuButton>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup className="flex-1 overflow-y-auto">
              <SidebarGroupLabel>Settings</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={currentPath.includes('/settings/preferences')}>
                      <Link to="/settings/preferences">
                        <SlidersHorizontal className="size-4" />
                        <span>Preferences</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={currentPath.includes('/settings/models')}>
                      <Link to="/settings/models">
                        <Bot className="size-4" />
                        <span>Models</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={currentPath.includes('/settings/integrations')}>
                      <Link to="/settings/integrations">
                        <Plug className="size-4" />
                        <span>Integrations</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={currentPath.includes('/settings/mcp-servers')}>
                      <Link to="/settings/mcp-servers">
                        <Server className="size-4" />
                        <span>MCP Servers</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarFooter />
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <div className="flex flex-col h-full">
            <header className="flex h-12 w-full items-center px-4">
              {!open && <SidebarTrigger className="cursor-pointer" />}
            </header>
            <div className="flex-1 overflow-auto">
              <Outlet />
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}
