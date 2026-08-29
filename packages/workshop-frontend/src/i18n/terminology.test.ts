import { describe, expect, it } from 'vitest'
import { applyProductTerminology } from './terminology'

describe('applyProductTerminology', () => {
  it('uses CinaSeek product language while preserving the archive extension', () => {
    expect(applyProductTerminology('Create a Gadget from a Blueprint', 'en'))
      .toBe('Create an App from a Template')
    expect(applyProductTerminology('Upload a .gadget archive', 'en'))
      .toBe('Upload a .gadget archive')
  })

  it('localizes product language for Chinese catalogs', () => {
    expect(applyProductTerminology('打开蓝图并检查 Gatekeeper', 'zh-CN'))
      .toBe('打开模板并检查 连接与权限')
    expect(applyProductTerminology('開啟藍圖並檢查 Gatekeeper', 'zh-TW'))
      .toBe('開啟範本並檢查 連線與權限')
  })
})
