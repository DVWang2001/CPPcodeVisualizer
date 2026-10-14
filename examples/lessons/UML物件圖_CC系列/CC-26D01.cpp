// UML 物件圖教案 CC-26D01：複數向量的總和、乘積與平均（欄位公開）
// （改寫自 CF 題目 CC-26D01：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<cmath>
#include<vector>
using namespace std;
class Complex{public:
   double x,y;
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex add(Complex p){return Complex(x+p.x,y+p.y);}
   Complex mul(Complex p){return Complex(x*p.x-y*p.y,y*p.x+x*p.y);}
   Complex div(double b){return Complex(x/b,y/b);}
   void read(){
      char c1,c2;
      cin>>x>>c1>>y>>c2;
      if(c1=='-')y*=-1;
   }
   void print(){
      if(y==0)cout<<x;
      else if(x==0)cout<<y<<"i";
      else if(y<0) cout<<x<<y<<"i";
      else cout<<x<<"+"<<y<<"i";
   }
};
class CVec{
public:
   vector<Complex> cv;
   Complex tol(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans.add(cv[i]);
      }
      return ans;
   }
   Complex cross(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans.mul(cv[i]);
      }
      return ans;
   }
   Complex avg(){
      return tol().div(cv.size());
   }
   void read(){
      int n;
      cin>>n;
      for(int i=0;i<n;i++){
         Complex c;
         c.read();
         cv.push_back(c);
      }
   }
};

int main(){
   CVec c;c.read();
   cout<<"sum:";c.tol().print();cout<<endl;  //@ @guide uml:c
   cout<<"Cross product:";c.cross().print();cout<<endl;
   cout<<"avg:";c.avg().print();cout<<endl;
   return 0;
}
