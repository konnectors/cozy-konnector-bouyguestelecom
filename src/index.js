import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://toscrape.com'
const defaultSelector = "a[href='http://quotes.toscrape.com']"
const loginLinkSelector = `[href='/login']`
const logoutLinkSelector = `[href='/logout']`
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
class TemplateContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm')
    await this.goto(baseUrl)
    this.log('info', 'navigateToLoginForm post goto')
    // await sleep(3000)
    // this.log('info', 'navigateToLoginForm post sleep')
    await this.waitForElementInWorker(defaultSelector)
    this.log('info', 'navigateToLoginForm 3')

    await this.runInWorker('click', defaultSelector)
    this.log('info', 'navigateToLoginForm 4')

    // wait for both logout or login link to be sure to check authentication when ready
    await Promise.race([
      this.waitForElementInWorker(loginLinkSelector),
      this.waitForElementInWorker(logoutLinkSelector)
    ])
    this.log('info', 'navigateToLoginForm 5')
  }

  async ensureAuthenticated() {
    this.log('info', 'EnsureAuthenticated')
    await this.goto('http://quotes.toscrape.com/login')
    // await this.waitForElementInWorker(defaultSelector)
    // await this.runInWorker('click', defaultSelector)
    await this.ensureNotAuthenticated()
    // throw new Error('✅️')
    // await this.navigateToLoginForm()
    // await sleep(3000)
    // this.log('info', 'navigateToLoginForm post sleep')
    try {
      await this.waitForElementInWorker(defaultSelector)
    } catch (err) {
      this.log('warn', err.message)
      throw new Error('🏮️🏮️🏮️🏮️🏮️')
    }
    throw new Error('✅️✅️✅️✅️✅️')
    // const authenticated = await this.runInWorker('checkAuthenticated')
    // if (!authenticated) {
    //   this.log('info', 'Not authenticated')
    //   await this.showLoginFormAndWaitForAuthentication()
    // }
    return true
  }

  async ensureNotAuthenticated() {
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }

    await this.clickAndWait(logoutLinkSelector, loginLinkSelector)
    return true
  }

  async checkAuthenticated() {
    return Boolean(document.querySelector(logoutLinkSelector))
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.clickAndWait(loginLinkSelector, '#username')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async fetch(context) {
    log.debug(context, 'fetch context')
    await this.goto('https://books.toscrape.com')
    await this.waitForElementInWorker('#promotions')
    const bills = await this.runInWorker('parseBills')

    for (const bill of bills) {
      await this.saveFiles([bill], {
        contentType: 'image/jpeg',
        fileIdAttributes: ['filename'],
        context
      })
    }
  }

  async getUserDataFromWebsite() {
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async parseBills() {
    const articles = document.querySelectorAll('article')
    return Array.from(articles).map(article => ({
      amount: normalizePrice(article.querySelector('.price_color')?.innerHTML),
      filename: article.querySelector('h3 a')?.getAttribute('title'),
      fileurl:
        'https://books.toscrape.com/' +
        article.querySelector('img')?.getAttribute('src')
    }))
  }
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('£', '').trim())
}

const connector = new TemplateContentScript()
connector.init({ additionalExposedMethodsNames: ['parseBills'] }).catch(err => {
  log.warn(err)
})
