; Modeleaf-owned PDF handler candidate registration.
; This deliberately does not write .pdf's default value or UserChoice.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\RegisteredApplications" "Modeleaf.Pdf" "Software\Classes\Modeleaf.Pdf\Capabilities"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf" "" "Modeleaf PDF Document"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf\Capabilities" "ApplicationName" "Modeleaf"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf\Capabilities" "ApplicationDescription" "Keyboard-first read-only PDF reader"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf\Capabilities\FileAssociations" ".pdf" "Modeleaf.Pdf"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Modeleaf.Pdf\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "Modeleaf.Pdf" ""
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $R9 SHCTX "Software\Classes\Modeleaf.Pdf\shell\open\command" ""
  ${If} $R9 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    ReadRegStr $R8 SHCTX "Software\RegisteredApplications" "Modeleaf.Pdf"
    ${If} $R8 == "Software\Classes\Modeleaf.Pdf\Capabilities"
      DeleteRegValue SHCTX "Software\RegisteredApplications" "Modeleaf.Pdf"
      DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Modeleaf.Pdf"
      DeleteRegKey SHCTX "Software\Classes\Modeleaf.Pdf"
    ${EndIf}
  ${EndIf}
!macroend
