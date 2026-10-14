; Dossier d'installation proposé en priorité : C:\agoa\AGOA-CCTP
; (sous-dossier dédié : la désinstallation ne touche pas les autres applications AGOA de C:\agoa).
; Appliqué uniquement à une première installation : un poste déjà installé conserve son dossier.
!macro preInit
  SetRegView 64
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" 0 +2
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\agoa\AGOA-CCTP"
  SetRegView 32
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" 0 +2
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\agoa\AGOA-CCTP"
!macroend
