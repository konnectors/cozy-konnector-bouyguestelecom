import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('bouyguestelecomCCC')

const baseUrl = 'https://bouyguestelecom.fr'
class BouyguesTelecomContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm')
    await this.goto(baseUrl)
  }

  async ensureAuthenticated() {
    this.log('info', 'EnsureAuthenticated')
    await this.goto('http://quotes.toscrape.com/login')
  }

  async ensureNotAuthenticated() {
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
  }

  async checkAuthenticated() {}

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async fetch(context) {
    this.log('info', 'fetch starts')
  }
}

const connector = new BouyguesTelecomContentScript()
connector.init({ additionalExposedMethodsNames: [] }).catch(err => {
  log.warn(err)
})
